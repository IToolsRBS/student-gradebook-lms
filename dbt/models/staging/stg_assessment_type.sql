select
    assessment_type_id::bigint as assessment_type_id,
    assessment_type_code::text as assessment_type_code,
    assessment_type_name::text as assessment_type_name
from {{ source('raw', 'assessment_type') }}