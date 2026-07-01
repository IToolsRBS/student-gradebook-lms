select
    p.programme_id,
    p.programme_code,
    p.programme_name,
    p.category_id,
    p.category_name,
    null::text as "year/sem",
    count(distinct s.student_id) as total_students

from {{ ref('stg_programme') }} p
left join {{ ref('stg_student') }} s
    on p.programme_id = s.programme_id

group by
    p.programme_id,
    p.programme_code,
    p.programme_name,
    p.category_id,
    p.category_name